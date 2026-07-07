#!/bin/bash
# Déploiement MindMap sur VPS Ubuntu/Debian
# Usage: sudo bash deploy/setup-vps.sh votredomaine.com

set -e

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo bash deploy/setup-vps.sh votredomaine.com"
  exit 1
fi

echo "=== 1. Installation des paquets ==="
apt update
apt install -y curl git nginx certbot python3-certbot-nginx

echo "=== 2. Installation Node.js 22 ==="
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
fi

echo "=== 3. Installation PM2 ==="
npm install -g pm2

echo "=== 4. Configuration Nginx ==="
sed "s/votredomaine.com/$DOMAIN/g" deploy/nginx.conf > /etc/nginx/sites-available/mindmap
ln -sf /etc/nginx/sites-available/mindmap /etc/nginx/sites-enabled/mindmap
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "=== 5. Certificat HTTPS (Let's Encrypt) ==="
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --redirect

echo "=== 6. Démarrage de l'application ==="
npm install --production
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || pm2 startup

echo ""
echo "✅ Déploiement terminé !"
echo "   Site : https://$DOMAIN"
echo ""
echo "N'oubliez pas de créer le fichier .env avec :"
echo "   JWT_SECRET=<clé aléatoire longue>"
echo "   DEEPSEEK_API_KEY=sk-..."
echo "   OPENAI_API_KEY=sk-..."
echo "Puis : pm2 restart mindmap"
