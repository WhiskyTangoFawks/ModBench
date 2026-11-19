namespace MEditService.PluginAdapter.Tests.TestSupport;

/// <summary>Every class that mutates process-wide state, an environment variable or the registered codecs, so none runs alongside another test.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ProcessEnvironmentCollection
{
    public const string Name = "Process environment collection";
}
