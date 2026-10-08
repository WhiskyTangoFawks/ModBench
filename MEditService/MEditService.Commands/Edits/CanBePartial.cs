using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>xEdit's GetCanBePartial: the type declares the flag; a temporary exterior cell never can;
/// where the game names one plugin, only a cell that plugin defines can.</summary>
internal static class CanBePartial
{
    internal static bool TypeDeclares(Type recordType) => PartialFormFlag.IsPartialFormable(recordType);

    /// <summary><paramref name="temporaryExterior"/> is null while a cell's placement is not yet known.</summary>
    internal static Verdict Of(RecordTableSchema schema, GameRelease release, string? formKey, bool? temporaryExterior)
    {
        if (!TypeDeclares(schema.RecordType)) return new Verdict.TypeDoesNotDeclare();
        if (!RecordTypeDispatch.For(release).IsCell(schema.TableName)) return new Verdict.Can();
        if (temporaryExterior is not { } temporary) return new Verdict.NeedsPlacement();
        if (temporary) return new Verdict.TemporaryExterior();
        return PartialFormFlag.CellsDefinedIn(release) is { } only && FormKey.TryFactory(formKey, out var key) && key.ModKey != only
            ? new Verdict.DefinedElsewhere(key.ModKey, only)
            : new Verdict.Can();
    }

    internal abstract record Verdict
    {
        private Verdict()
        {
        }

        internal sealed record Can : Verdict;

        internal sealed record TypeDoesNotDeclare : Verdict;

        internal sealed record NeedsPlacement : Verdict;

        internal sealed record TemporaryExterior : Verdict;

        internal sealed record DefinedElsewhere(ModKey DefinedBy, ModKey Only) : Verdict;
    }
}
