using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

public sealed class ApiWebAppFixture : IDisposable
{
    internal WebApplicationFactory<Program> App { get; } = new WebApplicationFactory<Program>();
    public void Dispose() => App.Dispose();
}
