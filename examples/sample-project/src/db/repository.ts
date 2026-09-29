import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function findOrdersByCustomer(customerId: string) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE customer_id = $1", [customerId]);
  return rows;
}
