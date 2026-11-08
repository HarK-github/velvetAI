# velvetAI Hackathon Submission & Hosting Deadlines

## 1. Hackathon Calendar & Submission Deadlines

| Milestone                        | Date & Time                                                                 | Notes                                       |
| :------------------------------- | :-------------------------------------------------------------------------- | :------------------------------------------ |
| **Feature Freeze**               | Friday, Nov 6, 2026                                                         | Polish, bugfixes, and integration only      |
| **Internal Code Freeze**         | Wednesday, Nov 11, 2026, 11:00 PM IST                                       | Hard cutoff for code modifications          |
| **Demo Rehearsal & Video**       | Thursday, Nov 12, 2026, morning IST                                         | 3-minute video walkthrough recording        |
| **Internal Submission Target**   | Thursday, Nov 12, 2026, 6:00 PM IST                                         | Devpost submission submitted early          |
| **Official Submission Deadline** | Thursday, Nov 12, 2026, 12:00 PM PST<br>(Friday, Nov 13, 2026, 1:30 AM IST) | Hard PayPal AI Hackathon portal deadline    |
| **Judging Period**               | December 1 – 15, 2026                                                       | Hosted deployment must remain live & funded |

---

## 2. Render Hosting Infrastructure & Budget Plan

All services are deployed under Render Workspace: **`velvetAI Hackathon`**.
Render Blueprint and Pricing References:

- Blueprint database spec: [Render Blueprint Databases](https://render.com/docs/blueprint-spec#databases)
- Blueprint services spec: [Render Blueprint Services](https://render.com/docs/blueprint-spec#services)
- PostgreSQL pricing & plans: [Render PostgreSQL Pricing](https://render.com/docs/postgresql-pricing)

### Resource Tiers & Monthly Cost Estimation

| Service Name                 | Render Type                | Plan / Tier           | Specs                                  | Monthly Cost        |
| :--------------------------- | :------------------------- | :-------------------- | :------------------------------------- | :------------------ |
| **`velvetai-db`**            | Managed PostgreSQL 17      | Basic (`basic-256mb`) | 0.25 CPU, 256 MB RAM, 100 conns, 10GB  | $7.00 / mo ($6+$1)  |
| **`velvetai-api`**           | Web Service (Docker)       | Starter (`starter`)   | 0.5 CPU, 512 MB RAM (preDeployCommand) | $7.00 / mo          |
| **`velvetai-worker`**        | Background Worker (Docker) | Starter (`starter`)   | 0.5 CPU, 512 MB RAM (Always-on)        | $7.00 / mo          |
| **`velvetai-web`**           | Static Site                | Free (`static`)       | Unlimited static requests, CDN         | $0.00 / mo          |
| **Total Estimated Run Cost** |                            |                       |                                        | **~$21.00 / month** |

### Hackathon Runway to End of Judging (Dec 15, 2026)

- **Available Credit**: **$50.00** (Promo "Hackathon Participant", valid through Nov 1, 2027).
- **Deployment Duration**: Nov 8, 2026 – Dec 15, 2026 (~37 days / ~1.233 months).
- **Total Compute & Storage Cost**: `~$21.00 * 1.233 = ~$25.90`.
- **Remaining Credit Balance on Dec 15**: `~$50.00 - $25.90 = ~$24.10` surplus cushion.
- **Runway**: Sufficient to keep all paid services running continuously for over 2.3 months without interruption.
