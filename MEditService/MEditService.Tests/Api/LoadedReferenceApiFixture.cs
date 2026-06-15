using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

public sealed class LoadedReferenceApiFixture : IAsyncLifetime, IDisposable
{
    private readonly ReferencePluginFixture _plugin = new();
    private readonly WebApplicationFactory<Program> _app = new();
    private bool _disposed;

    public HttpClient Client { get; private set; } = null!;
    public ReferencePluginFixture Plugin => _plugin;

    public async Task InitializeAsync()
    {
        Client = _app.CreateClient();
        var resp = await Client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _plugin.DataFolder,
            pluginsTxtPath = _plugin.PluginsTxtPath,
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
        _plugin.Dispose();
    }

    public Task DisposeAsync()
    {
        Dispose();
        return Task.CompletedTask;
    }
}
