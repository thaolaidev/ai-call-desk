#!/bin/sh
set -e
# แทนค่าเฉพาะตัวแปรของเรา (ไม่แตะ ${CALL_ID} ใน dialplan)
VARS='$SIP_HOST $SIP_PORT $SIP_USER $SIP_PASS $SIP_LOCAL_PORT $SIP_TRANSPORT $PUBLIC_IP $ARI_PASSWORD $CALLER_ID'
: "${SIP_TRANSPORT:=udp}"; export SIP_TRANSPORT
for f in /etc/asterisk-templates/*.conf; do
  envsubst "$VARS" < "$f" > "/etc/asterisk/$(basename "$f")"
done
# ไม่ลงทะเบียน (Yalecom อนุญาตตาม IP)
if [ "$SIP_REGISTER" = "no" ]; then
  sed -i '/^\[yalecom-reg\]/,/^$/d' /etc/asterisk/pjsip.conf
fi
mkdir -p /var/lib/asterisk/sounds/thaolai /var/spool/asterisk/recording
chown -R asterisk:asterisk /var/lib/asterisk/sounds/thaolai /var/spool/asterisk/recording
chmod 777 /var/lib/asterisk/sounds/thaolai /var/spool/asterisk/recording
exec asterisk -f -U asterisk -G asterisk -vvv
