from dataclasses import dataclass


@dataclass(frozen=True)
class Package:
    code: str
    flows: int
    price_usd: float

    @property
    def unit_price_usd(self) -> float:
        return round(self.price_usd / self.flows, 4)


PACKAGES: dict[str, Package] = {
    "indie_entry_150": Package(code="indie_entry_150", flows=150, price_usd=255.0),
    "growth_2000": Package(code="growth_2000", flows=2000, price_usd=3360.0),
    "scale_10000": Package(code="scale_10000", flows=10000, price_usd=16500.0),
}


def get_package_or_none(code: str) -> Package | None:
    return PACKAGES.get(code)
