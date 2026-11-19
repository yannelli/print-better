# Privacy

Print Better is self-hosted. The apps and the `printbetter` client only talk to the server you pair them with, and that server is yours.

## Print Better for iPhone and iPad
- **What it sends:** the files, photos, scans and pages you choose to print, plus the print settings, go to your paired server.
- **What it keeps on the device:**
  - the server address, device name and device token, in the Keychain;
  - the workspace name, the printer list and the last printer you used, in the app's settings.
- **Camera:** only for scanning pairing QR codes and documents. Scans stay on the device until you print them.
- **No tracking:** no analytics, ads, crash reporters or third-party SDKs. Nothing goes to the developer.
- **Removing data:** tap **Unpair** in the Settings tab, or delete the app. Your server's admins can remove the device and its jobs from **Devices**.

## Your Server
Whoever runs the server controls the jobs, audit log and accounts on it. Ask them how long they keep jobs and logs.

## Contact
Open an issue at https://github.com/yannelli/print-better/issues.
