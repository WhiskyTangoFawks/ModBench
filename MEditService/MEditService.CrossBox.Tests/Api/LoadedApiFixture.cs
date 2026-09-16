using System.Net.Http.Json;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.Api;

public sealed class LoadedApiFixture<TPlugin> : IAsyncLifetime, IDisposable
    where TPlugin : IApiPluginFixture<TPlugin>
{
    private readonly WebApplicationFactory<Program> _app = new();

    private HttpClient? _client;
    public HttpClient Client =>
        _client ?? throw new InvalidOperationException("InitializeAsync must run before the client is used.");
    public TPlugin Plugin { get; } = TPlugin.Create();
    public IServiceProvider Services => _app.Services;

    private bool _disposed;

    public async Task InitializeAsync()
    {
        _client = _app.CreateClient();
        var resp = await Client.PutLoadOrderAndAwaitReady(new
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
        _client?.Dispose();
        _app.Dispose();
        Plugin.Dispose();
    }

    // Any test's create-plugin call started a reconcile on its own thread and never awaited it:
    // deleting Plugin's files out from under one still running would race it (ADR-0003).
    public async Task DisposeAsync()
    {
        if (!_disposed && _client is not null)
        {
            var holder = Services.GetRequiredService<LoadOrderHolder>();
            await Client.AwaitTerminalLoadOrderStatus(holder.Version, TimeSpan.FromSeconds(10));
        }
        Dispose();
    }
}
