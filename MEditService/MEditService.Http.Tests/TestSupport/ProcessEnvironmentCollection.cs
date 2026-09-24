namespace MEditService.Http.Tests.TestSupport;

/// <summary>Every class that changes a process-wide environment variable such as PATH: any other
/// test running git while the change holds would fail for an unrelated reason, so this collection
/// never runs alongside another.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ProcessEnvironmentCollection
{
    public const string Name = "Process environment collection";
}
