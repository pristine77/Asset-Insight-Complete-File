# Asset Insight Complete File

Current source for the four independently runnable Asset Insight applications:

| Folder | Application |
| --- | --- |
| assetinsight-backend | API, report generation and background workers |
| assetinsight-client | Appraiser website |
| assetinsight-admin | Administration website |
| assetinsight-app | Android/iOS app and native camera modules |

Install dependencies separately in each folder with `npm ci`. Refer to each
package's scripts for development, type checks, tests and builds. Configure
environment variables locally; credentials and environment files are not included.
This is a source snapshot, not a deployment or application release.

The mobile source includes the October25 landscape reference layout and current
native capture/compression/offline features. A fresh native build is required.
Keep existing EAS release signing credentials; do not create replacement keys.
Local Android debug signing uses the standard developer-local debug keystore,
not a signing key distributed in this repository.

Build and deploy the backend/API and all workers before matching client updates.
Do not run deploy/migration/repair scripts as verification or without reviewing
their production target. Private operational files and customer artifacts are
not part of this repository.
