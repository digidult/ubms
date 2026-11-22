# Android app

`apps/android` is a Trusted Web Activity (TWA): a small Android app that opens the deployed web
app, https://ubms-html.vercel.app, in Chrome without browser UI. It holds no copy of the app.

## Why a wrapper and not a native app

The Android system WebView has no Web Bluetooth, so the desktop approach (the web app inside a
Tauri webview with a native Bluetooth bridge) would need a Bluetooth and USB serial bridge written
for Android and tested on devices. Chrome on Android already has Web Bluetooth, and a TWA runs the
page in Chrome itself, so device access works exactly as on the website.

What follows from that:

- Chrome (or another browser with Trusted Web Activity support) must be installed. Bluetooth works
  as in Chrome: the system asks for the Nearby devices (or Location) permission on behalf of Chrome.
- The first start needs the network. After that the service worker of the web app serves the
  cached copy offline, and loads a new build whenever the network is there.
- Updates of the web app reach the Android app without a new apk. A new apk is only needed when
  the wrapper itself changes.
- Serial ports depend on Chrome for Android (recent versions, USB adapters through WebUSB based
  Web Serial); this is not tested.
- A native Android app with its own Bluetooth bridge is a possible later stage.

## Verification and signing

Chrome hides its address bar only when the site confirms the app: `apps/web/public/.well-known/
assetlinks.json` lists the package `io.github.supakov.ubms` and the SHA-256 fingerprint of the
signing certificate. The Android workflow fails when a release-signed apk does not match that
file (`scripts/test/android.test.js` checks the package name and the format).

Every release must be signed with the same key: Android refuses to install an update signed with
another key, and Chrome would show the address bar again. The key is kept in the repository secrets
`ANDROID_KEYSTORE_BASE64` (a PKCS12 keystore, key alias `ubms`) and `ANDROID_KEYSTORE_PASSWORD`;
the project owner keeps a backup, because secrets cannot be read back. Without the secrets (forks,
pull requests) the apk is signed with a debug key and is only good for a try.

## Build

```
cd apps/android
gradle assembleRelease      # Gradle 8.9, JDK 17, Android SDK 34
```

The version comes from the root `package.json` (version code = major * 10000 + minor * 100 +
patch). CI: the workflow "Android" builds `ubms_<version>_android.apk` on every change of the
wrapper, and the workflow "Release" attaches it to a release.

To install: download the apk on the phone, open it and allow the installation from this source.
