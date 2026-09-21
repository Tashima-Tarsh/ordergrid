-- Flipkart managed authentication is OTP-only for both email and mobile identities.
-- Remove legacy saved passwords so there is a single authentication model.
delete from private.retailer_credentials rc
using public.retailer_accounts ra
where rc.tenant_id=ra.tenant_id
  and rc.retailer_account_id=ra.id
  and ra.retailer='flipkart';

update public.retailer_accounts
set credential_status='MISSING',
    last_credential_update_at=null,
    updated_at=now()
where retailer='flipkart'
  and credential_status<>'MISSING';
