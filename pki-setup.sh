set -e

PKI_PATH="samply_pki"

vault_pki_mount_exists() {
  vault secrets list -format=json |
    grep -q "\"${PKI_PATH}/\""
}

if [ -s /pki/root.crt.pem ] \
  && [ -s /pki/proxy1.priv.pem ] \
  && [ -s /pki/proxy2.priv.pem ] \
  && [ -s /pki/proxy3.priv.pem ] \
  && [ -s /pki/proxy4.priv.pem ] \
  && vault_pki_mount_exists; then

  echo "PKI files already exist. Skipping PKI setup."
  exit 0
fi

echo "$VAULT_TOKEN" > /pki/pki.secret

if vault_pki_mount_exists; then

  echo "Incomplete PKI setup found. Removing existing Vault PKI mount."
  vault secrets disable "$PKI_PATH"
fi

vault secrets enable -path="$PKI_PATH" pki

vault write -field=certificate "$PKI_PATH/root/generate/internal" common_name=broker > /pki/root.crt.pem

vault write "$PKI_PATH/roles/myrole" allowed_domains=broker allow_subdomains=true

vault write -field=private_key "$PKI_PATH/issue/myrole" common_name=proxy1.broker ttl=30d > /pki/proxy1.priv.pem
vault write -field=private_key "$PKI_PATH/issue/myrole" common_name=proxy2.broker ttl=30d > /pki/proxy2.priv.pem
vault write -field=private_key "$PKI_PATH/issue/myrole" common_name=proxy3.broker ttl=30d > /pki/proxy3.priv.pem
vault write -field=private_key "$PKI_PATH/issue/myrole" common_name=proxy4.broker ttl=30d > /pki/proxy4.priv.pem
