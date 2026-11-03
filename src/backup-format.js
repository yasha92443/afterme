// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// Keep this schema map in sync with migrations. It also bounds HTTP exports
// before D1 results and JSON serialization occupy Worker memory.
export const HTTP_BACKUP_MAX_BYTES=16*1024*1024;
export const RECOVERY_COLUMNS=Object.fromEntries(`
owner:id,display_name,email,state,last_checkin_at,release_suspended,created_at,updated_at,release_ready_at,confirmation_round,timer_anchor_at,pause_until,pause_mode
contacts:id,name,email,role,priority,can_release,token_hash,active,created_at,verification_round,verification_thread_id,locale,verification_issued_at,verification_expires_at
recipients:id,name,email,note,active,created_at,updated_at,locale
encrypted_items:id,kind,title,recipient_contact_id,assignee_contact_id,release_stage,encrypted_payload,payload_size,vault_token,vault_token_hash,released_at,created_at,recipient_id,pdf_payload,updated_at,revoked_at,revision,pdf_cache_key,delivery_version
public_farewell:id,title,body,status,updated_at,auto_released_at
public_farewell_items:id,title,body,sort_order,status,created_at,updated_at,entry_order
public_farewell_groups_v2:id,title,draft_title,sort_order,draft_sort_order,is_deleted,draft_is_deleted,is_committed,title_updated_at,draft_updated_at,created_at,epigraph,draft_epigraph,epigraph_updated_at,revision
public_farewell_entries_v2:id,group_id,draft_group_id,body,draft_body,is_public,draft_is_public,sort_order,draft_sort_order,is_deleted,draft_is_deleted,is_committed,body_updated_at,draft_updated_at,created_at,revision
legal_will:id,status,location,custodian,notes,updated_at
mail_templates:template_key,subject_template,body_template,updated_at
document_artifacts:artifact_key,filename,mime_type,content_base64,sha256,updated_at,layout_key
delivery_log:id,event_type,recipient_email,subject,provider,status,dedupe_key,attempts,last_error,created_at
mail_claims:dedupe_key,status,claimed_at,last_error,attempt_id,provider_message_id,provider_thread_id
private_delivery_state:item_id,status,reason,updated_at,content_version,next_attempt_at
user_settings:id,revision,preferences_json,active_rules_json,pending_rules_json,configured,updated_at,save_id,active_rule_version,pending_rule_version
round_rules:round,rules_json,anchor_at,created_at,rule_version
release_progress:round,channel,ready_at,released_at
confirmation_votes:contact_id,round,status,updated_at
admin_security:id,enabled,secret_payload,pending_payload,pending_id,pending_expires,last_counter,revision
admin_recovery_codes:code_hash,enrollment_id,used_at
farewell_document_versions:id,draft_revision,formal_revision,pending_count,write_token
pdf_artifacts:id,kind,item_id,source_revision,layout_key,locale,status,total_bytes,chunk_count,upload_revision,sha256,last_error,created_at,updated_at,validation_state,validation_cursor,validation_upload_revision,validation_manifest,validation_algorithm,validation_bytes,validation_mac,manifest_sha256,chunk_bytes
pdf_artifact_chunks:artifact_id,chunk_index,payload,sha256,byte_length
people_links:contact_id,recipient_id,revision,write_token,legacy_contact
background_jobs:id,job_key,dedupe_key,kind,confirmation_round,state,payload,checkpoint,lease_token,lease_until,attempt_id,next_attempt_at,last_error,created_at,updated_at
`.trim().split('\n').map(line=>{const [table,columns]=line.split(':');return [table,columns.split(',')];}));
export const RECOVERY_TABLES=Object.keys(RECOVERY_COLUMNS);
export function backupSizeSql(columns=RECOVERY_COLUMNS){return 'SELECT 8192+'+Object.entries(columns).map(([table,names])=>`COALESCE((SELECT SUM(length(CAST(json_object(${names.map(column=>`'${column}',"${column}"`).join(',')}) AS BLOB))+1) FROM "${table}"),0)`).join('+')+' AS bytes';}
export const BACKUP_SIZE_SQL=backupSizeSql();
