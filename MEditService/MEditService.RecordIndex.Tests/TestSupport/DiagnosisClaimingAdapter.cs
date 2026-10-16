using MEditService.Codec.Serialization;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Real plugins, each claiming the diagnoses it is given beside its hash.</summary>
internal sealed class DiagnosisClaimingAdapter(params PluginDiagnosis[] diagnoses) : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    public override Answer<FileClaim, PluginFailure> ClaimOf(string pluginPath, GameRelease gameRelease) =>
        base.ClaimOf(pluginPath, gameRelease).Holds(out var claim, out var failure)
            ? PluginAnswer.Of(claim with { Diagnoses = PluginAnswer.Of<IReadOnlyList<PluginDiagnosis>>(diagnoses) })
            : failure;
}
