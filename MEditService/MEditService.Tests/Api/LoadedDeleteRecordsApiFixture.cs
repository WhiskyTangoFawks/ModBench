using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

public sealed class LoadedDeleteRecordsApiFixture : IAsyncLifetime, IDisposable
{
    private readonly WebApplicationFactory<Program> _app = new();
    private bool _disposed;

    public HttpClient Client { get; private set; } = null!;
    public DeleteRecordsFixture Plugin { get; } = new();

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
}
