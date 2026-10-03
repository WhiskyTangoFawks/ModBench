namespace MEditService.Http.Tests.TestSupport;

public abstract class HostedTests : IDisposable
{
    private MEditHost _app;

    protected HostedTests()
    {
        _app = CreateHost();
        Client = _app.CreateClient();
    }

    protected HttpClient Client { get; private set; }

    protected IServiceProvider Services => _app.Services;

    private readonly List<IDisposable> _fixturesDisposedAfterTheHostStops = [];

    protected virtual MEditHost CreateHost() => new();

    protected T Owned<T>(T fixture) where T : IDisposable
    {
        _fixturesDisposedAfterTheHostStops.Add(fixture);
        return fixture;
    }

    protected void Restart()
    {
        StopTheService();
        _app = CreateHost();
        Client = _app.CreateClient();
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
