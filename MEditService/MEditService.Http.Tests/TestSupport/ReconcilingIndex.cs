using MEditService.Index;
using MEditService.Ports;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>An index that is still reconciling and holds nothing to read.</summary>
internal sealed class ReconcilingIndex : IQueryIndex
{
    public LoadOrderStatus Status { get; } = new(LoadOrderState.Reconciling, 1, 1, [], ConflictsComputed: false, []);

    public (string Sql, string Source)? ActiveFilter => null;

    public long Sequence => 0;

    public Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout) => Task.FromResult(false);

    public IRecordReads RequireReads() => throw new InvalidOperationException("Nothing is read while reconciling.");

    public IReadOnlyList<SourceFileFailure> SourceFileFailures => [];

    public void SetFilter(string sql, string source) => throw new NotSupportedException();

    public void ClearFilter() => throw new NotSupportedException();

    public StoreRebuild RebuildStore(GameRelease gameRelease, string instanceRoot) => throw new NotSupportedException();

    internal static void Replace(IServiceCollection services) => services.AddSingleton<IQueryIndex>(new ReconcilingIndex());
}
