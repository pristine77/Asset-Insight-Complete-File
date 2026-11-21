# Stuck lot videos on YouTube — for Manoj (2026-11-20)

A snapshot, not maintained documentation. The status below is what the admin
YouTube page (admin.assetinsightvaluator.com/youtube) showed on
2026-11-20 at about 8:30 PM Regina time: 76 videos, 67 Public, 8 at
"Needs attention" with no safe retry button, 1 data removed.

---

Hi Manoj,

8 lot videos are stuck at "Needs attention" on the admin YouTube page, and
none of them has a safe retry button. Can you take a look?

## 1. Ditch Witch report `6afc7728ee55211a64454ec3`

YouTube's daily upload limit stopped these mid-upload on 18 Nov. There is no
Resume button because the upload may have half-finished.

| Lot | Title | Video ID |
|---|---|---|
| 803 | 1996 Ford F-Super Duty Service Truck | `9f71034e8d34743a1ec1062d29d9a9b0518af3a54e48a1890308fdcf95ca8666` |
| 809 | 2012 Ford F-350 XLT Crew Cab 4x4 Flatbed | `ed8ef6afeebc93f6fb566e2fe960b011594f9be2b54fcb7a5b89ff0ceb65009a` |
| 814 | 1999 Western Star 4900 Van Body | `3c39d0828f62b832398808a7f705776e791282a23e10ec7c6eb64e139816a5e9` |
| 816 | Ditch Witch JT30 Directional Drill | `fb03c8dd5fb05485e39b655281febd6089c7c046e18b18fc7e9ff8684e10527c` |
| 817 | 2000 Ditch Witch JT920 Directional Drill | `3a6017fca39b87952b573fba48d0c2482a4bff484e0c46c239a75ac9759c3ccc` |

Please check YouTube Studio for partly uploaded or duplicate copies of these,
then either link the existing video or let them upload again.

## 2. "YouTube did not confirm public visibility", with no retry button

| Lot | Title | Report | Stopped | Video ID |
|---|---|---|---|---|
| 105 | 2011 Ram 1500 Laramie Truck | `6af233f98d61a7a344d578a4` | 16 Nov | `fd82d3c1e609cdd71dcdc97eb54b5a3a2defc8b2a7eea1de79499270a1c6beeb` |
| 93 | 2006 Ford E-150 Cargo Van | `6adbc8c581cd7dc84e6f9ad4` | 20 Nov | `0ae8b8850202ccfbe06989c90e4c1defa60761d7b94e05c19c5df304a49f8570` |

## 3. YouTube error 410 on 30 Oct

| Lot | Title | Report | Video ID |
|---|---|---|---|
| 630 | 2005 Polaris Fusion Liberty 700 Snowmobile | `6ae4d2dc6978c181f5d784bc` | `44a44e265192a360f22550ed2b641096ab86ec70e05d1385d465bccad924a6dd` |

It probably needs uploading again.

## Already done on 2026-11-20

I resumed the 8 videos that had a button (lots 1–6 of report
`6afdf4ba722fd7686924c97e`, lot 264 and lot 175). YouTube confirmed all of
them Public within about a minute.

## Pushed to main on 2026-11-20 — please review and deploy

- **113e8e0** — when a video goes Public after its lot was already sent to
  Auctioneer 2.0, the YouTube link is now sent to that lot. Before, it never
  arrived (for example, Auctioneer lot 0175, GMC TopKick).
  `assetinsight-backend/src/service/auctioneer2LateVideoService.ts`.
- **9a86f3b** — a stop for YouTube's daily limit no longer uses up the five
  tries. The video waits for the midnight Pacific reset and carries on by
  itself, and videos already parked by the limit resume after the reset.
  - I moved `publicationRetryKind` into `youtubeVideoService.ts` as
    `youtubeRetryKind`, so the admin Resume and the automatic resume share
    one rule.
  - One test in `youtube-video-service.test.ts` now fails publication with
    `requestFailed` instead of `quotaExceeded`, since a limit refusal no
    longer spends a try.
- **960d9a7** — CRM "Move Leads" with vacant pools (Bree's case: Tanner's
  Winnipeg leads).

## Also worth checking

Could we raise the YouTube daily limit for the Google project? On 18 Nov a
batch of 21 videos went over it.

Thanks!
