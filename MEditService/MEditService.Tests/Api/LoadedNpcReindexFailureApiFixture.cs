using System.Net.Http.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Session;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>
/// A loaded NPC session whose post-commit reindex always throws. Drives #127's stale-index case
/// through the real save path (the file swap still happens) and the
/// <see cref="ISessionManager.ReindexPlugins"/> seam — not by reaching into PluginSaver internals.
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
                services.RemoveAll<ISessionManager>();
                services.AddSingleton<SessionManager>();
                services.AddSingleton<ISessionManager>(sp =>
                    new ReindexThrowingSessionManager(sp.GetRequiredService<SessionManager>()));
            }));
    }

    public async Task InitializeAsync()
    {
        Client = _app.CreateClient();
        var resp = await Client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = Plugin.DataFolder,
            pluginsTxtPath = Plugin.PluginsTxtPath,
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

    /// <summary>Delegates everything to the real session manager but forces reindex to fail.</summary>
    private sealed class ReindexThrowingSessionManager(ISessionManager inner) : ISessionManager
    {
        public IGameSession? Session => inner.Session;
        public IRecordReads? Repository => inner.Repository;
        public IRecordIndex? Index => inner.Index;
        // #274: these stubs never load, so they are always in the no-session state.
        public SessionStatus Status => SessionStatus.None;

        public Task ReindexPlugin(string plugin) => throw new IOException("reindex failed (injected)");
        public Task ReindexPlugin(PluginKey key) => throw new IOException("reindex failed (injected)");
        public void UnindexPlugin(PluginKey key) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins) => throw new IOException("reindex failed (injected)");

        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) =>
            inner.Load(dataFolderPath, pluginsTxtPath, gameRelease);
        public void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease) =>
            inner.LoadExplicit(gameDirectory, plugins, gameRelease);
        public void Unload() => inner.Unload();
        public PluginResponse CreatePlugin(string name, string path, string origin) => inner.CreatePlugin(name, path, origin);
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => inner.LoadUnlistedPlugin(path, origin);
        public void UnloadUnlistedPlugin(string plugin, string origin) => inner.UnloadUnlistedPlugin(plugin, origin);
        public PluginResponse RereadPlugin(string plugin, string newPath, string newOrigin) => inner.RereadPlugin(plugin, newPath, newOrigin);
        public PluginResponse SetPluginParticipation(string plugin, bool participates) => inner.SetPluginParticipation(plugin, participates);
        public void SetFilter(string sql) => inner.SetFilter(sql);
        public void ClearFilter() => inner.ClearFilter();
        public void ReapplyFilter() => inner.ReapplyFilter();
    }
}
