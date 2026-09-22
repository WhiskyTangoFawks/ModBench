namespace MEditService.Http.Tests.TestSupport;

/// <summary>A class whose subject is the running service: one host, one client for it, and the
/// restart that proves what a process boundary carries.</summary>
public abstract class HostedTests : IDisposable
{
    private MEditHost _app;

    protected HostedTests()
    {
        _app = CreateHost();
        Client = _app.CreateClient();
    }

    protected HttpClient Client { get; private set; }

    // A subclass that needs a differently-shaped host (one that collects its own log output, for
    // instance) overrides this so Restart() rebuilds that same shape, not a bare one.
    protected virtual MEditHost CreateHost() => new();

    // Stop the service and start it again: the same files on disk, a new process, nothing carried
    // over in memory.
    protected void Restart()
    {
        Client.Dispose();
        _app.Dispose();
        _app = CreateHost();
        Client = _app.CreateClient();
    }

    // What the subclass built on disk, disposed after the host that was reading it.
    protected virtual void DisposeFixtures() { }

    public void Dispose()
    {
        Client.Dispose();
        _app.Dispose();
        DisposeFixtures();
        GC.SuppressFinalize(this);
    }
}
