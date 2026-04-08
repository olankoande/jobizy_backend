import { Router } from "express";
import { authRequired } from "../core/auth";
import { ApiError } from "../core/errors";
import { asyncHandler, ok } from "../core/http";
import {
  findReferrerByCode,
  getOrCreateReferralCode,
  getReferralStats,
} from "../services/referral";

export function referralsRouter() {
  const router = Router();

  // Returns the authenticated user's referral code + stats
  router.get(
    "/referrals/me",
    authRequired,
    asyncHandler(async (req, res) => {
      const stats = await getReferralStats(req.user!.id);

      if (!stats.referral_code) {
        stats.referral_code = await getOrCreateReferralCode(req.user!.id);
      }

      return ok(res, stats);
    }),
  );

  // Public — validate a referral code and return the referrer's first name
  router.get(
    "/referrals/validate/:code",
    asyncHandler(async (req, res) => {
      const referrer = await findReferrerByCode(String(req.params.code));
      if (!referrer) {
        throw new ApiError(404, "INVALID_REFERRAL_CODE", "Code de parrainage invalide.");
      }
      return ok(res, { valid: true, referrer_name: referrer.first_name });
    }),
  );

  return router;
}
