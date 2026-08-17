using MEditService.Core.Ledger;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.Api;

/// <summary>
/// Builds an API test host with <see cref="LedgerOptions"/> pointed at a fresh, private temp
/// directory instead of the real <c>%LOCALAPPDATA%</c> — the DI-singleton override Q1 (#370) calls
/// for, done per test rather than via <see cref="LoadedApiFixture{TPlugin}"/>'s shared
/// <c>IClassFixture</c> (these tests need one-off ledger roots, not a session shared across a whole
/// class), mirroring how <c>RealInstallSmokeTests</c> already builds its own
/// <see cref="WebApplicationFactory{TEntryPoint}"/> inline rather than through that shared fixture.
/// </summary>
internal static class VendoringTestHost
{
    internal static VendoringHost Create()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-ledger-root-").FullName;
        var app = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureServices(services => services.AddSingleton(new LedgerOptions(ledgerRoot))));
        return new VendoringHost(app, app.CreateClient(), ledgerRoot);
    }
}

internal sealed record VendoringHost(WebApplicationFactory<Program> App, HttpClient Client, string LedgerRoot) : IDisposable
{
    public void Dispose()
    {
        Client.Dispose();
        App.Dispose();
        if (Directory.Exists(LedgerRoot)) Directory.Delete(LedgerRoot, recursive: true);
    }
}
