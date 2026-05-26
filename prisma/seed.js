import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // 1️⃣ Categories
  const categories = [
    { name: "Burgers" },
    { name: "Pizza" },
    { name: "Sushi" },
    { name: "Desserts" },
  ];

  for (const cat of categories) {
    await prisma.category.upsert({
      where: { name: cat.name },
      update: {},
      create: cat,
    });
  }

  // 2️⃣ Vendors
  const vendors = [
    { name: "Burger King", isOpen: true, rating: 4.5, deliveryFee: 30 },
    { name: "Pizza Hut", isOpen: true, rating: 4.7, deliveryFee: 25 },
    { name: "Sushi Master", isOpen: true, rating: 4.8, deliveryFee: 50 },
  ];

  for (const vendor of vendors) {
    await prisma.restaurant.upsert({
      where: { name: vendor.name },
      update: {},
      create: vendor,
    });
  }

  // 3️⃣ Menu items
  const burgerKing = await prisma.restaurant.findUnique({ where: { name: "Burger King" } });
  const pizzaHut = await prisma.restaurant.findUnique({ where: { name: "Pizza Hut" } });
  const sushiMaster = await prisma.restaurant.findUnique({ where: { name: "Sushi Master" } });

  const menuItems = [
    { name: "Whopper", price: 150, restaurantId: burgerKing.id, isAvailable: true },
    { name: "Cheese Burger", price: 120, restaurantId: burgerKing.id, isAvailable: true },
    { name: "Margherita Pizza", price: 250, restaurantId: pizzaHut.id, isAvailable: true },
    { name: "Pepperoni Pizza", price: 300, restaurantId: pizzaHut.id, isAvailable: true },
    { name: "Salmon Sushi", price: 400, restaurantId: sushiMaster.id, isAvailable: true },
    { name: "Tuna Sushi", price: 350, restaurantId: sushiMaster.id, isAvailable: true },
  ];

  for (const item of menuItems) {
    await prisma.menuItem.upsert({
      where: { name: item.name },
      update: {},
      create: item,
    });
  }

  console.log("Database seeded ✅");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });