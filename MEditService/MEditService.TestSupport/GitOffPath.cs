namespace MEditService.TestSupport;

/// <summary>A machine with no git installed, for as long as one call runs. PATH is the process's own, so a
/// test using this joins the collection that serializes the process environment.</summary>
public static class GitOffPath
{
    public static T While<T>(Func<T> run)
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            return run();
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }
    }
}
