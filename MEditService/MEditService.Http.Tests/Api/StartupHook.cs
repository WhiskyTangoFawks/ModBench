using System.Reflection;

/// <summary>DOTNET_STARTUP_HOOKS requires a type named StartupHook in the global namespace. Lets a spawned backend load this assembly and what it references from this assembly's
/// directory, which the backend's own dependency file does not list, so the host can find StalledStartup.</summary>
internal static class StartupHook
{
    public static void Initialize()
    {
        var directory = Path.GetDirectoryName(typeof(StartupHook).Assembly.Location) ?? string.Empty;
        AppDomain.CurrentDomain.AssemblyResolve += (_, args) =>
        {
            var path = Path.Combine(directory, new AssemblyName(args.Name).Name + ".dll");
            return File.Exists(path) ? Assembly.LoadFrom(path) : null;
        };
    }
}
