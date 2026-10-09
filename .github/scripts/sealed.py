# Šifrované nastavení provozovny ve veřejném repozitáři.
# Soukromý klíč X25519 se odvozuje z proměnné SEAL_SEED (v nasazení tajemství repozitáře),
# takže soubor .enc umí otevřít jen nasazení.
#   python3 sealed.py pubkey                      vypíše veřejný klíč (env SEAL_SEED)
#   python3 sealed.py seal <pubkey> <in> <out>    zašifruje soubor
#   python3 sealed.py open <in> <out>             dešifruje (env SEAL_SEED)
import base64, hashlib, hmac, os, sys
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

RAW = dict(encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)


def private():
    seed = hmac.new(os.environ['SEAL_SEED'].encode(), b'oko1-config', hashlib.sha256).digest()
    return X25519PrivateKey.from_private_bytes(seed)


def aead(shared, eph):
    return AESGCM(HKDF(hashes.SHA256(), 32, None, b'oko1-sealed-v1').derive(shared + eph))


cmd = sys.argv[1]
if cmd == 'pubkey':
    print(base64.b64encode(private().public_key().public_bytes(**RAW)).decode())
elif cmd == 'seal':
    pub = X25519PublicKey.from_public_bytes(base64.b64decode(sys.argv[2]))
    eph = X25519PrivateKey.generate()
    e, nonce = eph.public_key().public_bytes(**RAW), os.urandom(12)
    ct = aead(eph.exchange(pub), e).encrypt(nonce, open(sys.argv[3], 'rb').read(), None)
    open(sys.argv[4], 'w').write(base64.b64encode(e + nonce + ct).decode() + '\n')
elif cmd == 'open':
    blob = base64.b64decode(open(sys.argv[2]).read())
    e, nonce, ct = blob[:32], blob[32:44], blob[44:]
    shared = private().exchange(X25519PublicKey.from_public_bytes(e))
    open(sys.argv[3], 'wb').write(aead(shared, e).decrypt(nonce, ct, None))
else:
    sys.exit('neznámý příkaz')
