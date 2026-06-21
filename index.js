const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(express.json({ limit: '50mb' }));

const FILES_DIR = path.join(__dirname, 'files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR);

const BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

// Print exactly what the container sees for R2 at startup
console.log('[R2 ENV CHECK]', JSON.stringify({
  R2_ACCESS_KEY_ID_length: (process.env.R2_ACCESS_KEY_ID || '').length,
  R2_SECRET_ACCESS_KEY_length: (process.env.R2_SECRET_ACCESS_KEY || '').length,
  R2_ENDPOINT: process.env.R2_ENDPOINT || 'MISSING',
  R2_BUCKET: process.env.R2_BUCKET || 'MISSING',
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL || 'MISSING'
}));

function getS3() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function uploadToR2(localPath, key, contentType) {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`R2 credentials missing in container: R2_ACCESS_KEY_ID present=${!!accessKeyId}, R2_SECRET_ACCESS_KEY present=${!!secretAccessKey}`);
  }
  const s3 = getS3();
  const body = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET || 'realestate-videos',
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

app.use('/files', express.static(FILES_DIR));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function downloadFile(url, destPath) {
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Probe a media file and return its duration in seconds (float).
function getDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const dur = metadata && metadata.format && metadata.format.duration;
      if (!dur || isNaN(dur)) return reject(new Error('Could not read duration from ' + filePath));
      resolve(parseFloat(dur));
    });
  });
}

app.post('/extract-frames', async (req, res) => {
  const { video_url, frame_interval_seconds = 2, max_width = 768 } = req.body;
  if (!video_url) return res.status(400).json({ error: 'video_url is required' });

  const jobId = uuidv4();
  const jobDir = path.join(FILES_DIR, jobId, 'frames');
  fs.mkdirSync(jobDir, { recursive: true });
  const videoPath = path.join(FILES_DIR, jobId, 'input.mp4');

  try {
    await downloadFile(video_url, videoPath);

    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions([
          `-vf fps=1/${frame_interval_seconds},scale=${max_width}:-1`,
          '-q:v 2'
        ])
        .output(path.join(jobDir, 'frame_%04d.jpg'))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const frameFiles = fs.readdirSync(jobDir)
      .filter(f => f.endsWith('.jpg'))
      .sort();

    const frames = frameFiles.map((file, index) => ({
      timestamp_seconds: index * frame_interval_seconds,
      image_url: `${BASE_URL}/files/${jobId}/frames/${file}`
    }));

    res.json({ job_id: jobId, frames });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/render-voiceover', async (req, res) => {
  const {
    video_url,
    voiceover_audio_binary,
    audio_url,
    music_url,                 // optional: soft background music track
    music_volume = 0.12,       // background music level (voiceover stays at 1.0)
    music_fade_seconds = 2     // fade music out over the last N seconds
  } = req.body;

  if (!video_url) return res.status(400).json({ error: 'video_url is required' });

  const jobId = uuidv4();
  const jobDir = path.join(FILES_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const videoPath = path.join(jobDir, 'input.mp4');
  const audioPath = path.join(jobDir, 'voiceover.mp3');
  const musicPath = path.join(jobDir, 'music.mp3');
  const outputPath = path.join(jobDir, 'final_voiceover.mp4');

  try {
    // 1. Get the video
    await downloadFile(video_url, videoPath);

    // 2. Get the voiceover (base64 from Make, or a URL)
    if (voiceover_audio_binary) {
      const audioBuffer = Buffer.from(voiceover_audio_binary, 'base64');
      fs.writeFileSync(audioPath, audioBuffer);
    } else if (audio_url) {
      await downloadFile(audio_url, audioPath);
    } else {
      return res.status(400).json({ error: 'audio_url or voiceover_audio_binary required' });
    }

    // 3. Optionally get background music
    let hasMusic = false;
    if (music_url) {
      try {
        await downloadFile(music_url, musicPath);
        hasMusic = true;
      } catch (e) {
        console.error('Music download failed, continuing voiceover-only:', e.message);
        hasMusic = false;
      }
    }

    // 4. Final length is governed by the VIDEO length
    const videoDuration = await getDurationSeconds(videoPath);
    const fadeStart = Math.max(0, videoDuration - music_fade_seconds);

    // 5. Build ffmpeg command.
    //    We NEVER reference the input video's audio ([0:a]), so silent
    //    videos render fine. Audio is built purely from voiceover (+music).
    await new Promise((resolve, reject) => {
      const command = ffmpeg(videoPath).input(audioPath); // 0 = video, 1 = voiceover

      if (hasMusic) {
        // Loop the music so short tracks still cover the whole video.
        command.input(musicPath).inputOptions(['-stream_loop', '-1']); // input 2 = music

        // [1:a] voiceover at full volume, padded so it never ends the mix early
        // [2:a] music looped, lowered, faded out near the end
        // amix duration=first -> mix length follows the voiceover-pad (which we
        //   pad to the video length via apad + the output -t cap)
        const filter =
          `[1:a]apad,volume=1.0[vo];` +
          `[2:a]volume=${music_volume},afade=t=out:st=${fadeStart.toFixed(2)}:d=${music_fade_seconds}[bg];` +
          `[vo][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`;

        command.complexFilter([filter])
          .outputOptions([
            '-map', '0:v',
            '-map', '[aout]',
            '-c:v', 'copy',
            '-t', videoDuration.toFixed(2),  // hard cap to video length
            '-shortest'
          ]);
      } else {
        // Voiceover only: attach it as the sole audio track.
        command.complexFilter([`[1:a]apad,volume=1.0[aout]`])
          .outputOptions([
            '-map', '0:v',
            '-map', '[aout]',
            '-c:v', 'copy',
            '-t', videoDuration.toFixed(2),
            '-shortest'
          ]);
      }

      command
        .output(outputPath)
        .on('start', cmd => console.log('[ffmpeg]', cmd))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const r2Key = `final/${jobId}.mp4`;
    const finalUrl = await uploadToR2(outputPath, r2Key, 'video/mp4');

    res.json({
      status: 'complete',
      final_video_url: finalUrl
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video worker running on port ${PORT}`));