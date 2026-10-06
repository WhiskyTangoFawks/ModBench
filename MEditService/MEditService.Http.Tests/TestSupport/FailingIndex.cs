using MEditService.Index;
using MEditService.Ports;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>Fails every question; given a rebuild refusal, answers a rebuild with it, as another
/// window's hold does.</summary>
internal sealed class FailingIndex(string? rebuildRefusal = null) : IQueryIndex
{
    public LoadOrderStatus Status => throw Failed();

    public (string Sql, string Source)? ActiveFilter => throw Failed();

    public long Sequence => throw Failed();

    public Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout) => throw Failed();

    public IRecordReads RequireReads() => throw Failed();

    public IReadOnlyList<SourceFileFailure> SourceFileFailures => throw Failed();

    public void SetFilter(string sql, string source) => throw Failed();

    public void ClearFilter() => throw Failed();

    public StoreRebuild RebuildStore(GameRelease gameRelease, string instanceRoot) =>
        rebuildRefusal is null ? throw Failed() : new StoreRebuild(Task.CompletedTask, rebuildRefusal);

    internal static void Replace(IServiceCollection services, string? rebuildRefusal = null) =>
        services.AddSingleton<IQueryIndex>(new FailingIndex(rebuildRefusal));

    private static InvalidOperationException Failed() => new("The index failed.");
}
