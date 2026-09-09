export const round2 = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

export const calculateDistanceKm = (lat1, lon1, lat2, lon2) => {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;

  const aLat = Number(lat1);
  const aLon = Number(lon1);
  const bLat = Number(lat2);
  const bLon = Number(lon2);

  if ([aLat, aLon, bLat, bLon].some(Number.isNaN)) return 0;

  const R = 6371;

  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const distance =
    R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return round2(distance);
};

export const calculateDeliveryFee = (cartTotal, distanceKm) => {
  const amount = Number(cartTotal || 0);
  const distance = Number(distanceKm || 0);

  /*
    DELIVERY RULES

    0 - 3 KM:
    Cart >= ₹99  -> FREE
    Cart < ₹99   -> ₹30

    Above 3 KM:
    ₹15 per KM
  */

  if (distance <= 3) {
    if (amount >= 99) {
      return 0;
    }

    return 30;
  }

  return Math.ceil(distance) * 15;
};

export default {
  round2,
  calculateDistanceKm,
  calculateDeliveryFee,
};