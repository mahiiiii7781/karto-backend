import prisma from "../prisma.js";

const EARTH_RADIUS_KM = 6371;

const calculateDistanceKm = (lat1, lon1, lat2, lon2) => {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_KM * c;
};

export const checkServiceability = async (req, res) => {
  try {
    const { lat, lng } = req.query;

    const latitude = Number(lat);
    const longitude = Number(lng);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid latitude and longitude are required.",
      });
    }

    const serviceAreas = await prisma.serviceArea.findMany({
      where: {
        isActive: true,
      },
    });

    let matchedArea = null;
    let distanceKm = null;

    for (const area of serviceAreas) {
      const distance = calculateDistanceKm(
        latitude,
        longitude,
        Number(area.latitude),
        Number(area.longitude)
      );

      if (distance <= Number(area.radiusKm)) {
        matchedArea = area;
        distanceKm = distance;
        break;
      }
    }

    if (!matchedArea) {
      return res.json({
        success: true,
        available: false,
        city: null,
        state: null,
        message: "Coming soon to your city.",
      });
    }

    return res.json({
      success: true,
      available: true,

      city: matchedArea.city,
      state: matchedArea.state,
      country: matchedArea.country,
      pinCode: matchedArea.pinCode,

      distanceKm: Number(distanceKm.toFixed(2)),
      radiusKm: Number(matchedArea.radiusKm),

      message: `Karto is available in ${matchedArea.city}.`,
    });
  } catch (error) {
    console.error("❌ Serviceability error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to check service availability.",
    });
  }
};