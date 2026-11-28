import db

def load(items):
    total = 0
    for item in items:
        db.find_many(item)
        total += 1
    try:
        risky()
    except Exception:
        pass
    return total
