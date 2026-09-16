namespace MEditService.Tests.TestSupport;

/// <summary>A class whose subject is the running service: one host, one client for it, and the
/// restart that proves what a process boundary carries.</summary>
public abstract class HostedTests : IDisposable
{
    private MEditHost _app = new();

    protected HostedTests() => Client = _app.CreateClient();

    protected HttpClient Client { get; private set; }

    // Stop the service and start it again: the same files on disk, a new process, nothing carried
    // over in memory.
    protected void Restart()
    {
        Client.Dispose();
        _app.Dispose();
        _app = new MEditHost();
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
