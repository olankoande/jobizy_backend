import { v4 as uuid } from "uuid";

export type UserStatus = "active" | "suspended" | "deleted";
export type ProviderStatus = "draft" | "pending_review" | "active" | "suspended" | "rejected";
export type RequestStatus = "draft" | "published" | "in_discussion" | "awarded" | "expired" | "cancelled" | "closed";
export type QuoteStatus = "sent" | "accepted" | "rejected" | "withdrawn";
export type MissionStatus = "confirmee" | "planifiee" | "en_cours" | "terminee" | "annulee" | "en_litige";
export type SubscriptionStatus = "draft" | "active" | "expired" | "cancelled";
export type ExternalPaymentStatus = "undefined" | "recorded" | "in_dispute";

export interface User {
  id: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  phone?: string;
  locale: string;
  email_verified_at: string | null;
  is_client_enabled: boolean;
  is_provider_enabled: boolean;
  status: UserStatus;
  role: "user" | "provider" | "admin";
  created_at: string;
  updated_at: string;
}

export interface ProviderProfile {
  id: string;
  user_id: string;
  display_name: string;
  business_name: string;
  description: string;
  logo_url?: string | null;
  cover_url?: string | null;
  verification_status: "unverified" | "pending" | "verified" | "rejected";
  provider_status: ProviderStatus;
  rating_avg: number;
  rating_count: number;
  response_rate?: number | null;
  response_time_avg_minutes?: number | null;
  completed_missions_count: number;
  is_profile_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlatformSettings {
  id: string;
  currency: string;
  default_locale: string;
  supported_locales: string[];
  brand_logo_url: string;
  pwa_push_enabled: boolean;
  request_auto_expiry_days: number;
  request_publication_payment_enabled?: boolean;
  default_request_publication_price_cents?: number;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string;
  image_url?: string | null;
  marketing_title?: string | null;
  marketing_subtitle?: string | null;
  status: "active" | "inactive";
  sort_order: number;
}

export interface Service {
  id: string;
  category_id: string;
  name: string;
  slug: string;
  description: string;
  image_url?: string | null;
  marketing_title?: string | null;
  price_label?: string | null;
  indicative_price_label?: string | null;
  status: "active" | "inactive";
  base_publication_price_cents?: number | null;
  sort_order: number;
}

export interface Zone {
  id: string;
  parent_id: string | null;
  type: "country" | "province" | "city" | "sector";
  name: string;
  code: string;
  image_url?: string | null;
  marketing_blurb?: string | null;
  status: "active" | "inactive";
}

export interface ProviderService {
  id: string;
  provider_profile_id: string;
  service_id: string;
  status: "active" | "inactive";
  created_at: string;
}

export interface ProviderZone {
  id: string;
  provider_profile_id: string;
  zone_id: string;
  coverage_type: "primary" | "secondary";
  created_at: string;
}

export interface Availability {
  id: string;
  provider_profile_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RequestRecord {
  id: string;
  client_user_id: string;
  category_id: string | null;
  service_id: string;
  zone_id: string;
  title: string;
  description: string;
  desired_date: string | null;
  time_window_start: string | null;
  time_window_end: string | null;
  urgency: "low" | "standard" | "high" | "urgent";
  budget_min_cents: number | null;
  budget_max_cents: number | null;
  budget_indicative_cents: number | null;
  work_mode: "onsite" | "remote" | "hybrid";
  status: RequestStatus;
  offers_count: number;
  new_offers_count: number;
  unread_messages_client_count: number;
  action_required_client: boolean;
  published_at: string | null;
  expires_at: string | null;
  cancelled_at?: string | null;
  cancelled_by_user_id?: string | null;
  cancellation_reason?: string | null;
  cancellation_note?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Match {
  id: string;
  request_id: string;
  provider_profile_id: string;
  subscription_id: string | null;
  match_score: number;
  match_reason: string;
  is_visible_to_provider: boolean;
  notified_at: string | null;
  responded_at: string | null;
  created_at: string;
}

export interface Quote {
  id: string;
  request_id: string;
  provider_profile_id: string;
  message: string;
  indicative_price_cents: number | null;
  estimated_price_cents?: number | null;
  delay_days: number | null;
  proposed_date: string | null;
  proposed_time_window: string | null;
  status: QuoteStatus;
  unread_messages_client_count: number;
  unread_messages_provider_count: number;
  submitted_at: string;
  updated_at: string;
}

export interface Mission {
  id: string;
  request_id: string;
  quote_id: string;
  client_user_id: string;
  provider_profile_id: string;
  indicative_price_cents: number | null;
  status: MissionStatus;
  unread_messages_client_count: number;
  unread_messages_provider_count: number;
  dispute_opened: boolean;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_by_user_id?: string | null;
  cancellation_reason?: string | null;
  cancellation_note?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  channel: "in_app";
  is_read: boolean;
  created_at: string;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  badge: string | null;
  max_responses: number | null;
  response_limit?: number | null;
  priority_level: number;
  price_cents: number;
  currency: string;
  billing_interval: "monthly";
  status: "active" | "inactive";
}

export interface Subscription {
  id: string;
  user_id: string;
  provider_profile_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  starts_at: string | null;
  ends_at: string | null;
  cancelled_at?: string | null;
  cancelled_by_user_id?: string | null;
  cancellation_reason?: string | null;
  cancellation_note?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExternalPayment {
  id: string;
  mission_id: string;
  amount_indicative_cents: number | null;
  method: string | null;
  status: ExternalPaymentStatus;
  comment: string | null;
  created_at: string;
  updated_at: string;
}

export function createId(prefix: string) {
  void prefix;
  return uuid();
}

export function timestamp() {
  return new Date().toISOString();
}
