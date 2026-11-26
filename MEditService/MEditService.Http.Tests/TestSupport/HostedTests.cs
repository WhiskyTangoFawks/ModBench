using MEditService.TestSupport;

namespace MEditService.Http.Tests.TestSupport;

public abstract class HostedTests : IDisposable
{
    private readonly MEditHost _app;

    protected HostedTests()
    {
        _app = CreateHost();
        Client = _app.CreateClient();
    }

    protected HttpClient Client { get; }

    protected IReadOnlyList<LogEntry> Logged
    {
        get
        {
            lock (_app.Logged) return [.. _app.Logged];
        }
    }

    private readonly List<IDisposable> _fixturesDisposedAfterTheHostStops = [];

    protected virtual MEditHost CreateHost() => new();

    protected T Owned<T>(T fixture) where T : IDisposable
    {
        _fixturesDisposedAfterTheHostStops.Add(fixture);
        return fixture;
    }

    protected virtual void DisposeFixtures() { }

    private void StopTheService()
    {
        Client.Dispose();
        _app.Dispose();
    }

    public void Dispose()
    {
        StopTheService();
        foreach (var fixture in _fixturesDisposedAfterTheHostStops) fixture.Dispose();
        DisposeFixtures();
        GC.SuppressFinalize(this);
    }
}
