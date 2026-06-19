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

// R2 (S3-compatible) client
const R2_BUCKET = process.env.R2_BUCKET || 'realestate-videos';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Upload a local file to R2 and return its public URL
async function uploadToR2(localPath, key, contentType) {
  const body = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return `${R2_PUBLIC_URL}/${key}`;
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
  const { video_url, voiceover_audio_binary, audio_url, duck_original_audio = true, original_audio_volume = 0.15 } = req.body;
  if (!video_url) return res.status(400).json({ error: 'video_url is required' });

  const jobId = uuidv4();
  const jobDir = path.join(FILES_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const videoPath = path.join(jobDir, 'input.mp4');
  const audioPath = path.join(jobDir, 'voiceover.mp3');
  const outputPath = path.join(jobDir, 'final_voiceover.mp4');

  try {
    await downloadFile(video_url, videoPath);

    if (voiceover_audio_binary) {
      const audioBuffer = Buffer.from(voiceover_audio_binary, 'base64');
      fs.writeFileSync(audioPath, audioBuffer);
    } else if (audio_url) {
      await downloadFile(audio_url, audioPath);
    } else {
      return res.status(400).json({ error: 'audio_url or voiceover_audio_binary required' });
    }

    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .input(audioPath)
        .complexFilter([
          duck_original_audio
            ? `[0:a]volume=${original_audio_volume}[orig];[orig][1:a]amix=inputs=2:duration=shortest[aout]`
            : `[1:a]acopy[aout]`
        ])
        .outputOptions(['-map 0:v', '-map [aout]', '-c:v copy', '-shortest'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Upload finished video to R2 and return the permanent public URL
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