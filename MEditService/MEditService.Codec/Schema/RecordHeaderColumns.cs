using System.Globalization;
using System.Reflection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>One type's record header members as columns, in the annotation table's order: each row
/// whose interface the type carries and declares the member on.</summary>
internal static class RecordHeaderColumns
{
    private const string FlagsMember = nameof(IMajorRecordGetter.MajorRecordFlagsRaw);

    // Every bit, so each flag view Mutagen spells over the raw integer shows up.
    private const long AllBits = -1;

    internal static List<ColumnSpec> For(
        Type getterType, ILookup<string, PropertyInfo> declarations, string pathPrefix, GameReflection game, ILogger logger)
    {
        var columns = new List<ColumnSpec>();
        foreach (var (typeName, member, label) in game.Annotations.RecordHeaderMembers)
        {
            var declared = declarations[member].ToList();
            if (!declared.Exists(p => ReflectedTypes.DeclaringTypeOf(p).Name == typeName)) continue;
            var prop = ReflectedTypes.MostDerived(declared);
            if (ColumnReflection.BuildColumn(prop, pathPrefix + prop.Name, game, logger) is not { } column) continue;

            var header = column with { Field = column.Field with { DisplayLabel = label, IsRecordHeaderMember = true } };
            columns.Add(member == FlagsMember ? WithFlagViews(header, getterType, declarations, game) : header);
        }
        return columns;
    }

    // Record Flags names the bits of every flag view Mutagen spells over the raw integer, and those
    // views are its aliases.
    private static ColumnSpec WithFlagViews(
        ColumnSpec flags, Type getterType, ILookup<string, PropertyInfo> declarations, GameReflection game)
    {
        var aliases = game.Defaults.MembersAliasing(getterType, FlagsMember, AllBits);
        return flags with { Field = flags.Field with { EnumMembers = BitNames(aliases, declarations) }, Aliases = aliases };
    }

    private static List<EnumMember> BitNames(IReadOnlyList<string> aliases, ILookup<string, PropertyInfo> declarations)
    {
        var byBit = new SortedDictionary<long, (EnumMember Member, Type Declaring)>();
        foreach (var view in aliases.Where(declarations.Contains).Select(a => ReflectedTypes.MostDerived(declarations[a])))
        {
            var core = ReflectedTypes.CoreOf(view).Core;
            if (!core.IsEnum || core.GetCustomAttribute<FlagsAttribute>() == null) continue;
            var declaring = ReflectedTypes.DeclaringTypeOf(view);
            foreach (var member in LeafClassification.GetEnumMembers(core))
            {
                if (member.BitValue is not { } bitValue) continue;
                var bit = long.Parse(bitValue, CultureInfo.InvariantCulture);
                if (!byBit.TryGetValue(bit, out var held) || IsNarrower(declaring, held.Declaring))
                    byBit[bit] = (member, declaring);
            }
        }
        return [.. byBit.Values.Select(v => v.Member)];
    }

    // The game's flags and the record type's own both name some bits; the type's word is the
    // narrower one.
    private static bool IsNarrower(Type candidate, Type held) => held.IsAssignableFrom(candidate);
}
