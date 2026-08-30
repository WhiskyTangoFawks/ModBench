using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

public sealed class LoadedApiFixture<TPlugin> : IAsyncLifetime, IDisposable
    where TPlugin : IApiPluginFixture<TPlugin>
{
    private readonly WebApplicationFactory<Program> _app = new();

    public HttpClient Client { get; private set; } = null!;
    public TPlugin Plugin { get; } = TPlugin.Create();
    public IServiceProvider Services => _app.Services;

    private bool _disposed;

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
}
