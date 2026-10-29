#!/bin/bash
# Retail Demo – Kindersicherung für Webseiten (macOS)
# version 1
#
# Läuft als root über launchd (/Library/LaunchDaemons/de.retaildemo.webfilter.plist): beim Ändern der
# Konfiguration und alle 2 Minuten. Die Laptop-App schreibt nur die Konfiguration, dieses Skript
# setzt sie um:
#   - Jugendschutz-DNS auf allen Netzwerkdiensten (blockiert Pornografie, Glücksspiel usw. für alle Browser)
#   - eigene Sperrliste in /etc/hosts
# Wird DNS von Hand zurückgestellt, setzt das Skript ihn beim nächsten Lauf wieder.
#
# webfilter.conf: 1. Zeile Filterstufe (off / family / strict), danach eine Domain pro Zeile.
set -u
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

DIR="/Library/Application Support/RetailDemo"
CONF="$DIR/webfilter.conf"
STATE="$DIR/webfilter.state"
STATUS="$DIR/webfilter.status"
HOSTS=/etc/hosts
BEGIN="# >>> RetailDemo Kindersicherung (nicht von Hand ändern)"
END="# <<< RetailDemo Kindersicherung"

mode=off
[ -f "$CONF" ] && mode=$(head -n 1 "$CONF" | tr -cd 'a-z')
case "$mode" in
  # Cloudflare for Families: Schadsoftware + Inhalte für Erwachsene
  family) dns="1.1.1.3 1.0.0.3 2606:4700:4700::1113 2606:4700:4700::1003" ;;
  # CleanBrowsing Family: zusätzlich Proxys/VPNs gesperrt und SafeSearch bei Google/Bing/YouTube erzwungen
  strict) dns="185.228.168.168 185.228.169.168 2a0d:2a00:1:: 2a0d:2a00:2::" ;;
  *) mode=off; dns="" ;;
esac

changed=0

# ---------------------------------------------------------------- DNS
current_dns() {
  local out
  out=$(networksetup -getdnsservers "$1" 2>/dev/null)
  case "$out" in
    *"aren't any"*|*"Keine"*|"") echo "Empty" ;;
    *) echo "$out" | tr '\n' ' ' | sed 's/ *$//' ;;
  esac
}

if [ "$mode" != off ]; then
  while IFS= read -r svc; do
    case "$svc" in ""|\**) continue ;; esac   # "*" = deaktivierter Dienst
    cur=$(current_dns "$svc")
    if [ "$cur" != "$dns" ]; then
      # Ursprüngliche Einstellung merken, um sie beim Ausschalten wiederherzustellen
      if ! grep -qF "$svc|" "$STATE" 2>/dev/null; then echo "$svc|$cur" >> "$STATE"; fi
      # shellcheck disable=SC2086
      networksetup -setdnsservers "$svc" $dns && changed=1
    fi
  done < <(networksetup -listallnetworkservices 2>/dev/null | tail -n +2)
elif [ -f "$STATE" ]; then
  while IFS='|' read -r svc orig; do
    [ -n "$svc" ] || continue
    # shellcheck disable=SC2086
    networksetup -setdnsservers "$svc" ${orig:-Empty} && changed=1
  done < "$STATE"
  rm -f "$STATE"
fi

# ---------------------------------------------------------------- Sperrliste (/etc/hosts)
block=""
if [ "$mode" != off ] && [ -f "$CONF" ]; then
  while IFS= read -r d; do
    d=$(echo "$d" | tr 'A-Z' 'a-z' | tr -d ' \r')
    # nur gültige Domains übernehmen
    echo "$d" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' || continue
    block="$block"$'\n'"0.0.0.0 $d www.$d"$'\n'":: $d www.$d"
  done < <(tail -n +2 "$CONF" | head -n 500)
fi

old=$(sed -n "/^$BEGIN\$/,/^$END\$/p" "$HOSTS")
new=""
[ -n "$block" ] && new="$BEGIN$block"$'\n'"$END"
if [ "$old" != "$new" ]; then
  tmp=$(mktemp /tmp/hosts.XXXXXX)
  sed "/^$BEGIN\$/,/^$END\$/d" "$HOSTS" > "$tmp"
  [ -n "$new" ] && printf '%s\n' "$new" >> "$tmp"
  cat "$tmp" > "$HOSTS"
  rm -f "$tmp"
  changed=1
fi

if [ "$changed" = 1 ]; then
  dscacheutil -flushcache
  killall -HUP mDNSResponder 2>/dev/null
fi

echo "$mode $(date +%s)" > "$STATUS"
chmod 644 "$STATUS"
