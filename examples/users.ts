import axios from "axios";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface User {
  id: number;
  name: string;
  email: string;
}

/** Loads a user from the database, falling back to the profile API when the row is missing. */
export async function getUser(id: number): Promise<User> {
  if (!Number.isInteger(id) || id <= 0) throw new RangeError("id must be a positive integer");
  const { rows } = await pool.query("SELECT id, name, email FROM users WHERE id = $1", [id]);
  if (rows.length > 0) return rows[0];

  const response = await axios.get(`https://api.example.com/users/${id}`);
  return response.data;
}

/** Copies a user from the profile API into the database. Returns false if the API has no such user. */
export async function importUser(id: number): Promise<boolean> {
  try {
    const { data } = await axios.get(`https://api.example.com/users/${id}`);
    await pool.query("INSERT INTO users (id, name, email) VALUES ($1, $2, $3)", [data.id, data.name, data.email.toLowerCase()]);
    return true;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return false;
    throw error;
  }
}

export async function countUsersByDomain(domain: string): Promise<number> {
  const { rows } = await pool.query("SELECT COUNT(*) AS count FROM users WHERE email LIKE $1", [`%@${domain.toLowerCase()}`]);
  return Number(rows[0].count);
}
