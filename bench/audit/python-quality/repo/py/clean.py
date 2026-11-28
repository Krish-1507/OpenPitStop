def load(items):
    try:
        return [item.value for item in items]
    except ValueError as error:
        print(error)
        raise
