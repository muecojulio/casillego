export function PrivacyCopy() {
  return (
    <article className="space-y-5 text-sm leading-relaxed text-fg/90">
      <p>
        Casillego avisa cuando estás cerca de bajarte. No pide cuenta y no tiene una base de datos
        en la nube con tus rutas.
      </p>
      <section className="space-y-2">
        <h2 className="font-display text-xl text-fg">Qué se queda en el teléfono</h2>
        <p>
          Las rutas cotidianas, la distancia de la alarma y el viaje en curso se guardan solo en
          este dispositivo (almacenamiento local del navegador). Nadie más puede leerlos desde
          Casillego. Si borras los datos del sitio, se van.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="font-display text-xl text-fg">Qué sale del teléfono</h2>
        <p>Solo cuando tú buscas o pides tu ubicación:</p>
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>El texto de búsqueda va a Nominatim (OpenStreetMap), una consulta a la vez.</li>
          <li>
            Si pides estaciones cerca o las salidas de una parada, las coordenadas aproximadas van a un
            servidor público Overpass de OpenStreetMap.
          </li>
          <li>El mapa se dibuja con teselas de OpenFreeMap, también de OpenStreetMap.</li>
        </ul>
        <p>
          Esas consultas sirven para encontrar la parada. No se adjuntan a una cuenta, no se
          venden y no hay publicidad ni rastreadores de Casillego.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="font-display text-xl text-fg">Permisos</h2>
        <p>
          La ubicación se usa para medir la distancia a tu bajada. El sonido y la vibración suenan
          en la página. “Pantalla activa” pide al sistema que no apague la pantalla durante el
          viaje. En iPhone, iOS no deja que una app instalada desde el navegador siga el GPS con
          la pantalla bloqueada: deja Casillego abierto.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="font-display text-xl text-fg">Cómo borrar</h2>
        <p>
          En Ajustes, “Borrar rutas guardadas” vacía este dispositivo. También puedes borrar los
          datos de la app desde los ajustes del teléfono.
        </p>
      </section>
    </article>
  );
}
