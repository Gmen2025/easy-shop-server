# Cloudinary Mobile Upload Example

This file shows a minimal React Native example that:

- Requests a server-side signature from `POST /api/v1/cloudinary/sign`
- (Compatibility) You can also call legacy `POST /sign`
- Uploads the image directly to Cloudinary using the returned signature
- Returns the uploaded image `secure_url` which you can save on your product

Prerequisites
- Server reachable from device/emulator (use LAN IP or ngrok)
- `CLOUDINARY_*` env vars configured on the server

React Native example (using `react-native-image-picker`):

```javascript
import { launchImageLibrary } from 'react-native-image-picker';

async function pickAndUpload() {
  const res = await launchImageLibrary({mediaType: 'photo'});
  if (!res.assets || res.assets.length === 0) return null;
  const asset = res.assets[0];
  const localUri = asset.uri;
  const publicId = `eshop/products/${Date.now()}`;
  const folder = 'eshop/products';

  // 1) Ask backend for a signature
  const signResp = await fetch('http://<BACKEND_HOST>:3001/api/v1/cloudinary/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params_to_sign: { public_id: publicId, folder } })
  });
  const { signature, api_key, timestamp, cloud_name } = await signResp.json();

  // 2) Upload to Cloudinary
  const form = new FormData();
  form.append('file', { uri: localUri, name: 'photo.jpg', type: 'image/jpeg' });
  form.append('api_key', api_key);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('public_id', publicId);
  form.append('folder', folder);

  const uploadUrl = `https://api.cloudinary.com/v1_1/${cloud_name}/image/upload`;
  const uploadRes = await fetch(uploadUrl, { method: 'POST', body: form });
  const uploadJson = await uploadRes.json();

  // secure_url contains the durable image URL
  return uploadJson.secure_url;
}
```

Notes
- Replace `<BACKEND_HOST>` with your server IP or hostname reachable from the mobile device.
- For Android emulators, use `10.0.2.2` (emulator) or LAN IP for physical devices.
- You can skip server signing by using an unsigned `upload_preset` configured in Cloudinary, but this is less secure.

Saving to product
- After successful upload, call your products API (`POST /api/v1/products`) and set the `image` field to the returned `secure_url`.
