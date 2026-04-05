const { sendJobAlert, sendNoLocksmithAlert } = require("./sms");

/**
 * @param {import("pg").Pool} pool
 * @param {string} suburb
 * @param {string} service API service key e.g. car_lockout
 * @param {string} province GP | WC
 * @param {number[]} excludeIds
 * @param {number} limit
 */
async function findMatchingLocksmiths(
  pool,
  suburb,
  service,
  province,
  excludeIds = [],
  limit = 5
) {
  const ex = Array.isArray(excludeIds) ? excludeIds.filter((n) => Number.isFinite(n)) : [];
  const { rows } = await pool.query(
    `SELECT id, name, phone, email, customer_code
     FROM locksmiths
     WHERE LOWER(status) = 'active'
       AND expiry_date IS NOT NULL
       AND expiry_date > NOW()
       AND province = $1
       AND $2 = ANY(coverage_areas)
       AND services @> jsonb_build_array($3::text)
       AND (cardinality($4::int[]) = 0 OR NOT (id = ANY($4::int[])))
     ORDER BY RANDOM()
     LIMIT $5`,
    [province, suburb, service, ex, limit]
  );
  return rows;
}

/**
 * @param {import("pg").Pool} pool
 * @param {number} jobId
 */
async function dispatchJob(pool, jobId) {
  const adminPhone = process.env.ADMIN_PHONE?.trim();

  const { rows: jobRows } = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [
    jobId,
  ]);
  if (jobRows.length === 0) {
    console.error("[dispatchJob] job not found:", jobId);
    return;
  }
  const job = jobRows[0];
  const notifiedIds = Array.isArray(job.notified_ids) ? job.notified_ids : [];
  const suburb = job.suburb;
  const service = job.service;
  const province = job.province;

  const locksmiths = await findMatchingLocksmiths(
    pool,
    suburb,
    service,
    province,
    notifiedIds,
    5
  );

  if (locksmiths.length === 0) {
    await pool.query(`UPDATE jobs SET status = 'no_coverage' WHERE id = $1`, [
      jobId,
    ]);
    if (adminPhone) {
      await sendNoLocksmithAlert(adminPhone, job);
    } else {
      console.warn("[dispatchJob] ADMIN_PHONE not set — no admin alert for no_coverage");
    }
    return;
  }

  const newIds = locksmiths.map((l) => l.id);
  const merged = [...new Set([...notifiedIds, ...newIds])];

  for (const lm of locksmiths) {
    const ok = await sendJobAlert(lm.phone, job);
    await pool.query(
      `INSERT INTO sms_logs (recipient, message, job_id, status, provider)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        lm.phone,
        `[job alert] ${job.job_code}`,
        jobId,
        ok ? "sent" : "failed",
        "smsportal",
      ]
    );
  }

  await pool.query(
    `UPDATE jobs
     SET notified_ids = $1::integer[],
         notified_count = notified_count + $2,
         status = 'dispatched'
     WHERE id = $3`,
    [merged, locksmiths.length, jobId]
  );
}

module.exports = {
  findMatchingLocksmiths,
  dispatchJob,
};
