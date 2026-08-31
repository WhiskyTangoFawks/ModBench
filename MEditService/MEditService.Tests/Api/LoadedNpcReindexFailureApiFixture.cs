using System.Net.Http.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>
/// A loaded NPC load order whose post-commit reindex always throws. Drives #127's stale-index case
/// through the real save path (the file swap still happens) and the
/// <see cref="ILoadOrderMirror.ReindexPlugin(string)"/> seam — not by reaching into PluginSaver internals.
/// </summary>
public sealed class LoadedNpcReindexFailureApiFixture : IAsyncLifetime, IDisposable
{
    private readonly WebApplicationFactory<Program> _app;

    public HttpClient Client { get; private set; } = null!;
    public TestPluginFixture Plugin { get; } = new();

    private bool _disposed;

    public LoadedNpcReindexFailureApiFixture()
    {
        _app = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<ILoadOrderMirror>();
                services.AddSingleton<LoadOrderMirror>();
                services.AddSingleton<ILoadOrderMirror>(sp =>
                    new ReindexThrowingMirror(sp.GetRequiredService<LoadOrderMirror>()));
            }));
    }

    public async Task InitializeAsync()
    {
        Client = _app.CreateClient();
        var resp = await Client.PutAsJsonAsync("/load-order", new
        {
            plugins = Plugin.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameDirectory = Plugin.DataFolder,
            instanceRoot = Plugin.InstanceRoot,
            gameRelease = "Fallout4",
        });
        resp.EnsureSuccessStatusCode();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Client?.Dispose();
        _app.Dispose();
        Plugin.Dispose();
    }

    public Task DisposeAsync()
    {
        Dispose();
        return Task.CompletedTask;
    }

    /// <summary>Delegates everything to the real load order manager but forces reindex to fail.</summary>
    private sealed class ReindexThrowingMirror(ILoadOrderMirror inner) : ILoadOrderMirror
    {
        public ILoadOrder? LoadOrder => inner.LoadOrder;
        public IRecordReads? Reads => inner.Reads;
        public IRecordIndex? Index => inner.Index;
        // #274: these stubs never load, so they are always in the no-load order state.
        public LoadOrderStatus Status => LoadOrderStatus.None;
        public (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope() => inner.RequireScope();

        public Task ReindexPlugin(string plugin) => throw new IOException("reindex failed (injected)");
        public Task ReindexPlugin(PluginKey key) => throw new IOException("reindex failed (injected)");
        public void UnindexPlugin(PluginKey key) => throw new NotSupportedException();

        public void Reconcile(
            string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease,
            string? instanceRoot = null) =>
            inner.Reconcile(gameDirectory, plugins, gameRelease, instanceRoot);
        public void Close() => inner.Close();
        public PluginResponse CreatePlugin(string name, string path, string origin) => inner.CreatePlugin(name, path, origin);
        public void SetFilter(string sql) => inner.SetFilter(sql);
        public void ClearFilter() => inner.ClearFilter();
        public void ReapplyFilter() => inner.ReapplyFilter();
    }
}
