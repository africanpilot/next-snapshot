import Counter from "./Counter";
import YearFilter from "./YearFilter";

// A server component that reads the query: each ?year= is its own server
// render, so the offline file needs each one captured.
export default async function Home({ searchParams }) {
  const { year } = await searchParams;
  return (
    <main>
      <h1>Home</h1>
      <p id="year">year: {year ?? "none"}</p>
      <Counter />
      <YearFilter year={year ?? "2025"} />
    </main>
  );
}
