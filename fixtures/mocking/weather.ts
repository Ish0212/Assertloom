export interface Forecast {
  city: string;
  celsius: number;
}

export async function getForecast(city: string): Promise<Forecast> {
  const response = await fetch(`https://weather.example.com/v1/current?city=${encodeURIComponent(city)}`);
  if (!response.ok) throw new Error(`Weather API error: ${response.status}`);
  const body = (await response.json()) as { temp_c: number };
  return { city, celsius: Math.round(body.temp_c) };
}
