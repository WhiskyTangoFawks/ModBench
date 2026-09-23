namespace MEditService.SourceAdapter.Tests.TestSupport;

/// <summary>Every class that mutates process-wide environment variables (PATH, HOME, git config):
/// any other test calling real git while one of these holds the mutation would break on an
/// unrelated failure, so this collection never runs alongside another.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ProcessEnvironmentCollection
{
    public const string Name = "Process environment collection";
}
