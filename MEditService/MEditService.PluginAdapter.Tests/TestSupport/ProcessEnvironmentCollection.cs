namespace MEditService.PluginAdapter.Tests.TestSupport;

/// <summary>Every class that mutates a process-wide environment variable, so none runs alongside another test.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ProcessEnvironmentCollection
{
    public const string Name = "Process environment collection";
}
