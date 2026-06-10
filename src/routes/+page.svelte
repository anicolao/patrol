<svelte:head>
  <title>Patrol</title>
</svelte:head>

<main class="home" aria-label="Patrol home">
  <h1>Patrol</h1>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #f7f7f4;
    color: #171a1f;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      sans-serif;
  }

  .home {
    display: grid;
    min-height: 100vh;
    place-items: center;
  }

  h1 {
    margin: 0;
    font-size: 2rem;
    font-weight: 650;
    letter-spacing: 0;
  }
</style>
