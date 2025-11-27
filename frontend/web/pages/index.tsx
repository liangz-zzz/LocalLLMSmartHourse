import { useEffect, useState } from "react";

type Device = {
  id: string;
  name: string;
  traits?: any;
};

export default function Home() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/devices");
        const data = await res.json();
        setDevices(data.items || []);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  return (
    <main style={{ padding: "2rem", fontFamily: "Arial, sans-serif" }}>
      <h1>Devices</h1>
      {loading && <p>Loading...</p>}
      <ul>
        {devices.map((d) => (
          <li key={d.id}>
            <strong>{d.name}</strong> ({d.id})
          </li>
        ))}
      </ul>
    </main>
  );
}
